const express = require('express');
const axios = require('axios').default;
const app = express();
const ansiColors = require('ansi-colors');
const fs = require('fs');
const dotenv = require('dotenv');

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

const port = 8000
const datas = []

var requestId = 0
const startProccessAt = new Date().getTime()

async function chat_completions(req, res, type) {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    data = req.body
    let query = "";
    if(type == "chat") {
        query = data.messages[1]['content'].slice(14)
    }
    else {
        let query_index = data.prompt.indexOf('Search query: ')
        query = data.prompt.slice(query_index + 14)
    }
    let tokens = 0
    let startAt = new Date().getTime()
    if (cache.has(query)) {
        console.info(ansiColors.blue(`✓ Cache hit! ${query}`))
        const stream = await cache.get(query)
        res.writeHead(stream.status, stream.headers);
        stream.data.pipe(res)
        return
    }
    console.info(`==> ${type} ${requestId ++} / ${(new Date().getTime() - startProccessAt) / 1000}s:`, query);
    const clientIp = req.socket.remoteAddress;
    const ip4 = clientIp.split(":").pop();
    console.info(ansiColors.green(`IP: ${ip4}, Headers: ${JSON.stringify(req.headers["epistula-signed-by"], null, 2)}`));
    try {
        promise = axios.post(
            `http://${server}:${port}/v1/` + (type == "chat" ? "chat/completions" : "completions"),
            data,
            { 
                headers: {
                    'Content-Type': 'application/json'
                },
                responseType: 'stream'
            }
        )
        datas.push({
            type, data
        })
        setTimeout(() => {
            fs.writeFileSync('data.json', JSON.stringify(datas, null, 2))
        }, 0)
        cache.set(query, promise)
        stream = await promise
        stream.data.setMaxListeners(100)
        res.writeHead(stream.status, stream.headers);
        stream.data.pipe(res);
        stream.data.on('data', () => {
            tokens += 1
        })
        stream.data.on('error', (err) => {
            console.error('Error in stream data stream:', err);
            res.end();
        });
      
        // Close the stream when the stream ends
        stream.data.on('end', () => {
            res.end();
            const period = new Date().getTime() - startAt
            console.log(`tps: ${tokens / period * 1000}, tokens: ${tokens}, period: ${period/1000}`)
        });
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
    await chat_completions(req, res, "chat")
});

app.post('/v1/completions', async (req, res) => {
    await chat_completions(req, res, "completions")
});

app.get('/health', (req, res) => {
    res.status(200).send('Healthy')
});

// Start the Express server
app.listen(8000, () => {
  console.log('Server started on port:', ansiColors.green(8000));
});

process.on('warning', e => console.warn(e.stack));