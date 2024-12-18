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

function convert_to_stream(model, request_type, output_sequence, is_first = false) {
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
        if( is_first )
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
                // powv: output_sequence[i].powv,
                token_ids: [output_sequence[i].token_id],
                logprobs: {
                    tokens: [`token_id:${output_sequence[i].token_id}`],
                    // text_offset,
                    token_logprobs: [output_sequence[i].logprob],
                    top_logprobs: {[output_sequence[i].text]: output_sequence[i].logprob}
                }
            }]
        }
        if( request_type == "CHAT") {
            stream_data.choices[0].delta = {
                content: output_sequence[i].text,
            }
            stream_data.choices[0].logprobs['content'] = [{
                "token": `token_id:${output_sequence[i].token_id}`,
                "logprob": output_sequence[i].logprob,
            }]
        }
        const data_to_send = `data: ${JSON.stringify(stream_data)}\n\n`
        const buffer = Buffer.from(data_to_send, 'utf-8')
        stream.push(buffer)
        text_offset += output_sequence[i].text.length
    }
    return stream
}

async function get_stream_response(request_type, data) {
    const response = await axios.post(
        `http://${server}:${port}/v2/` + (request_type == "CHAT" ? "chat/completions" : "COMPLETIONS"),
        data,
        { 
            responseType: 'stream'
        }
    )
    return response.data
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
    if (cache.has(query)) {
        console.info(ansiColors.blue(`✓ Cache hit! ${query}`))
        const responses = cache.get(query)
        let index = 0
        timeout = 10
        let tokens = 0
        while((new Date().getTime() - startAt) / 1000 < timeout) {
            if (responses.length == index) {
                await timer(1)
                continue
            }
            for (; index < responses.length; index++) {
                tokens += responses[index].length
                if(responses[index] == 'END') {
                    res.end()
                    const period = new Date().getTime() - startAt
                    console.log(`tps: ${tokens / period * 1000}, tokens: ${tokens}, period: ${period/1000}, query: ${query}`)
                    return
                }
                if(version == 1) {
                    data_to_stream = convert_to_stream(model, type, responses[index], index == 0, false)
                    res.write(data_to_stream.reduce((a,b) => a + b, Buffer.from("", 'utf-8')))
                }
                else {
                    res.write(JSON.stringify(responses[index]))
                }
            }
        }
        console.warn("Timeout")
        res.end()
        return
    }
    console.info(`==> ${type} ${requestId ++} / ${(new Date().getTime() - startProccessAt) / 1000}s:`, model, query);
    const responses = []
    cache.set(query, responses)
    stream = await get_stream_response(type, data)
    setTimeout(() => {
        cache.delete(query)
    }, 60000)
    let output_sequence = []
    for await (const data of stream) {

        let outputs = []
        try {
            const text = data.toString()
            const datas = text.split("][")
            if(datas.length == 1) {
                outputs = JSON.parse(text)
            } else if(datas.length == 2) {
                outputs_1 = JSON.parse(datas[0] + "]")
                outputs_2 = JSON.parse("[" + datas[1])
                outputs = outputs_1.concat(outputs_2)
            }
        } catch (error) {
            console.error("Error parsing JSON", data.toString())
        }
        responses.push(outputs)
        if(version == 1) {
            let data_to_stream = convert_to_stream(model, type, outputs, output_sequence.length == 0, false)
            res.write(data_to_stream.reduce((a,b) => a + b, Buffer.from("", 'utf-8')))
        }
        else {
            res.write(JSON.stringify(outputs))
        }
        output_sequence.push(...outputs)
    }
    responses.push('END')
    if(version == 1){
        res.write(Buffer.from("data: [DONE]\n\n", 'utf-8'))
    }
    res.end()
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