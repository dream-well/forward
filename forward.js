const express = require('express');
const axios = require('axios').default;
const app = express();
const ansiColors = require('ansi-colors');
const dotenv = require('dotenv');
const crypto = require('crypto');

dotenv.config()

console.log('Server Location:', ansiColors.yellow(process.env.REGION));

var cache = new Map();

// Middleware to parse JSON bodies
app.use(express.json());

const servers = {
    "east": "10.142.0.3",
    "west": "10.168.0.5",
    "eu": "10.156.0.3"
}

const region = process.env.REGION
const server = servers[region]

console.log('Server IP:', server);

const port = 8000

var requestId = 0
const startProccessAt = new Date().getTime()

function generateId(request_type) {
    const prefix = request_type == 'CHAT' ? 'chat-' : 'cmpl-';
    const id = crypto.randomBytes(16).toString('hex'); // Generates a 32-character hexadecimal string
    return prefix + id;
}

function convert_to_stream(request_type, output_sequence) {
    let text_offset = 0
    const id = generateId()
    const stream = []
    if( request_type == "CHAT") {
        const stream_data = {
            "id": id, 
            "object":"chat.completion.chunk",
            "created":Math.floor((new Date()).getTime()/1000),
            "model":"NousResearch/Meta-Llama-3.1-8B-Instruct",
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
        const stream_data = {
            id: id,
            object: request_type == "CHAT" ? "chat.completion.chunk": "text_completion",
            // created: Math.floor((new Date()).getTime()/1000),
            // model: "NousResearch/Meta-Llama-3.1-8B-Instruct",
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
    console.log('Stream:', stream.slice(stream.length - 3).map(buf => buf.toString('utf-8')))
    return stream
}

async function get_stream_response(request_type, data) {
    const response = await axios.post(
        `http://${server}:${port}/v2/` + (request_type == "CHAT" ? "chat/completions" : "COMPLETIONS"),
        data,
        { 
            headers: {
                'Content-Type': 'application/json'
            },
        }
    )
    output_sequence = response.data
    console.log(output_sequence.slice(0, 3))
    return convert_to_stream(request_type, output_sequence)
}

async function stream_completions(req, res, type, version = 1) {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    data = req.body
    let query = "";
    if(type == "CHAT") {
        query = data.messages[1]['content'].slice(14)
    }
    else {
        let query_index = data.prompt.indexOf('Search query: ')
        query = data.prompt.slice(query_index + 14)
    }
    let startAt = new Date().getTime()
    if (cache.has(query)) {
        console.info(ansiColors.blue(`✓ Cache hit! ${query}`))
        const stream = await cache.get(query)
        if (version == 1) {
            for (let i = 0; i < stream.length; i++) {
                res.write(stream[i])
            }
        }
        if (version == 2) {
            console.log("Version 2")
            res.write(stream.reduce((a,b) => a+b))
        }
        res.end()
        return
    }
    console.info(`==> ${type} ${requestId ++} / ${(new Date().getTime() - startProccessAt) / 1000}s:`, query);
    const clientIp = req.socket.remoteAddress;
    const ip4 = clientIp.split(":").pop();
    console.info(ansiColors.green(`IP: ${ip4}, Headers: ${JSON.stringify(req.headers["epistula-signed-by"], null, 2)}`));
    try {
        promise = get_stream_response(type, data)
        cache.set(query, promise)
        setTimeout(() => {
            cache.delete(query)
        }, 60000)
        stream = await promise
        const send_at = new Date().getTime()
        if (version == 1) {
            for (let i = 0; i < stream.length; i++) {
                res.write(stream[i])
            }
        }
        if (version == 2) {
            console.log("Version 2")
            res.write(stream.reduce((a,b) => a+b))
        }
        res.end()
        const period = new Date().getTime() - startAt
        const tokens = stream.length
        const send_period = new Date().getTime() - send_at
        console.log(`tps: ${tokens / period * 1000}, tokens: ${tokens}, period: ${period/1000}, query: ${query}, sent in ${send_period/1000} s`)
    } catch (error) {
        console.error(error)
    }
}

app.use((req, res, next) => {
    try {
        next()
    } catch (error) {
        console.error(error)
        res.status(500).send('Internal Server Error')
    }
})

app.post('/v1/chat/completions', async (req, res) => {
    await stream_completions(req, res, "CHAT")
});

app.post('/v1/completions', async (req, res) => {
    await stream_completions(req, res, "COMPLETIONS")
});

app.post('/v2/chat/completions', async (req, res) => {
    await stream_completions(req, res, "CHAT", 2)
});

app.post('/v2/completions', async (req, res) => {
    await stream_completions(req, res, "COMPLETIONS")
});

app.get('/health', (req, res) => {
    res.status(200).send('Healthy')
});

// Start the Express server
app.listen(8000, () => {
  console.log('Server started on port:', ansiColors.green(8000));
});

process.on('warning', e => console.warn(e.stack));