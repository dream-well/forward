const express = require('express');
const axios = require('axios').default;
const app = express();
const ansiColors = require('ansi-colors');
const dotenv = require('dotenv');
const crypto = require('crypto');

const timer = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

dotenv.config()

console.log('Server Location:', ansiColors.yellow(process.env.REGION));

var cache = new Map();

// Middleware to parse JSON bodies
app.use(express.json());

const server = process.env.SERVER

console.log('Server IP:', server);

const port = 8000

var requestId = 0
const startProccessAt = new Date().getTime()

function generateId(request_type) {
    const prefix = request_type == 'CHAT' ? 'chat-' : 'cmpl-';
    const id = crypto.randomBytes(16).toString('hex'); // Generates a 32-character hexadecimal string
    return prefix + id;
}

function convert_to_stream(model, request_type, output_sequence) {
    let text_offset = 0
    const id = generateId()
    const stream = []
    if( request_type == "CHAT") {
        const stream_data = {
            "id": id, 
            "object":"chat.completion.chunk",
            // "created":Math.floor((new Date()).getTime()/1000),
            "model":model,
            "choices":[{
                "index":0,
                "delta":{"role":"assistant"},
            }]
        }
        const data_to_send = `data: ${JSON.stringify(stream_data)}\n\n`
        const buffer = Buffer.from(data_to_send, 'utf-8')
        stream.push(buffer)
    }
    for (let i = 0; i < output_sequence.length; i++) {
        if( !output_sequence[i].text ) {
            continue
        }
        const stream_data = {
            id: id,
            object: request_type == "CHAT" ? "chat.completion.chunk": "text_completion",
            // created: Math.floor((new Date()).getTime()/1000),
            // model: model,
            choices: [{
                index: 0,
                text: output_sequence[i].text,
                powv: output_sequence[i].powv,
                token_ids: [output_sequence[i].token_id],
                logprobs: {
                    text_offset,
                    token_logprobs: [output_sequence[i].logprob],
                    tokens: [output_sequence[i].text],
                    top_logprobs: {[output_sequence[i].text]: output_sequence[i].logprob}
                }
            }]
        }
        if( request_type == "CHAT") {
            stream_data.choices[0].delta = {
                content: output_sequence[i].text,
            }
            stream_data.choices[0].logprobs['content'] = [{
                "token": output_sequence[i].text,
                "logprob": output_sequence[i].logprob,
            }]
        }
        const data_to_send = `data: ${JSON.stringify(stream_data)}\n\n`
        const buffer = Buffer.from(data_to_send, 'utf-8')
        stream.push(buffer)
        text_offset += output_sequence[i].text.length
    }
    stream.push(Buffer.from("data: [DONE]\n\n", 'utf-8'))
    // console.log('Stream:', stream.slice(stream.length - 3).map(buf => buf.toString('utf-8')))
    return stream
}

async function get_stream_response(request_type, data) {
    const response = await axios.post(
        `http://${server}:${port}/v3/` + (request_type == "CHAT" ? "chat/completions" : "COMPLETIONS"),
        data,
        { 
            responseType: 'stream'
        }
    )
    const time = new Date().getTime()
    return new Promise((resolve) => {
        let output_sequence = []
        let first_sequence = []
        let output = ""
        let all_promise = new Promise((all_resolve) => {
            response.data.on('end', () => {
                output_sequence = JSON.parse(output)
                all_resolve(output_sequence)
            })
        })
        response.data.on('data', (chunk) => {
            if(first_sequence.length == 0) {
                first_sequence = JSON.parse(chunk.toString())
                console.log(`first token in ${new Date().getTime() - time}ms`, first_sequence)
                resolve([first_sequence, all_promise])
            }
            else {
                output += chunk.toString()
            }
        })
    })
}

async function stream_completions(req, res, type, version = 1) {
    if (version == 1 || version == 3) {
        res.setHeader('Content-Type', 'text/event-stream');
        res.setHeader('Cache-Control', 'no-cache');
        res.setHeader('Connection', 'keep-alive');
    }
    data = req.body
    let query = "";
    let model = data.model;
    if(type == "CHAT") {
        query = data.messages[1]['content'].slice(14)
    }
    else {
        let query_index = data.prompt.indexOf('Search query: ')
        query = data.prompt.slice(query_index + 14)
    }
    query = `version: ${version}, ` + query
    let startAt = new Date().getTime()
    let promise
    if (cache.has(query)) {
        console.info(ansiColors.blue(`✓ Cache hit! ${query}`))
        promise = cache.get(query)
    } else {
        console.info(`==> ${type} ${requestId ++} / ${(new Date().getTime() - startProccessAt) / 1000}s:`, model, query);
        promise = get_stream_response(type, data)
        cache.set(query, promise)
        setTimeout(() => {
            cache.delete(query)
        }, 60000)
    }
    let response = await promise
    let [first_sequence, all_promise] = response
    let first_stream = []
    if (version == 3) {
        res.write(JSON.stringify(first_sequence))
    }
    else if(version == 1) {
        first_stream = convert_to_stream(model, type, first_sequence).slice(0, -1)
        res.write(first_stream.reduce((a,b) => a+b))
    }
    let output_sequence = await all_promise
    if (version == 2) {
        return res.json(output_sequence)
    }
    else if (version == 3) {
        res.write(JSON.stringify(output_sequence))
        res.end()
        return
    }
    else if(version == 1) {
        output_stream = convert_to_stream(model, type, output_sequence).slice(first_stream.length)
        const output_5th = output_stream.slice(0, output_stream.length * 0.05 + 3)
        const rest_stream = output_stream.slice(output_5th.length)
        res.write(output_5th.reduce((a,b) => a+b))
        const spent = (new Date().getTime() - startAt)
        const end_time = spent * 0.25
        let wait_time = Math.max(end_time - (rest_stream.length + 100), 10) * 2
        if(rest_stream.length < 300)
            wait_time = Math.max(wait_time, 500)
        await timer(wait_time)
        console.log(`Spent: ${spent} ms, End time: ${end_time} ms, Wait: ${wait_time} ms, Length: ${rest_stream.length}`)
        res.write(rest_stream.reduce((a,b) => a+b))
        res.end()
    }
    const period = new Date().getTime() - startAt
    const tokens = output_sequence.length
    console.log(`tps: ${tokens / period * 1000}, tokens: ${tokens}, period: ${period/1000}, query: ${query}`)
}

app.use((req, res, next) => {
    try {
        const clientIp = req.socket.remoteAddress;
        const ip4 = clientIp.split(":").pop();
        if(req.path != "/health")
            console.info(ansiColors.green(`IP: ${ip4}, ${req.path}, Headers: ${JSON.stringify(req.headers["epistula-signed-by"], null, 2)}`));
        next()
    } catch (error) {
        console.error(error)
        res.status(500).send('Internal Server Error')
    }
})

app.post('/v1/chat/completions', async (req, res) => {
    await stream_completions(req, res, "CHAT", 1)
});

app.post('/v1/completions', async (req, res) => {
    await stream_completions(req, res, "COMPLETIONS", 1)
});

app.post('/v2/chat/completions', async (req, res) => {
    await stream_completions(req, res, "CHAT", 2)
});

app.post('/v2/completions', async (req, res) => {
    await stream_completions(req, res, "COMPLETIONS", 2)
});

app.post('/v3/chat/completions', async (req, res) => {
    await stream_completions(req, res, "CHAT", 3)
});

app.post('/v3/completions', async (req, res) => {
    await stream_completions(req, res, "COMPLETIONS", 3)
});

app.get('/health', (req, res) => {
    res.status(200).send('Healthy')
});

app.get('/models', async (req, res) => {
    const models = await axios.get(`http://${server}:${port}/models`).then(res => res.data)
    console.log("Requesting models", models)
    res.status(200).json(models)
})

app.post('/models', (req, res) => {
    models = req.body
    console.log("Receiving models", models)
    res.send("")
})

// Start the Express server
app.listen(8000, () => {
  console.log('Server started on port:', ansiColors.green(8000));
});

process.on('warning', e => console.warn(e.stack));