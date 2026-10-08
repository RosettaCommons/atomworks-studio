const http = require('node:http');
const mode = process.argv[2];
const port = Number(process.argv[process.argv.indexOf('--port') + 1]);
console.log(`PID=${process.pid}`);
if (mode === 'fail') {
  console.error('Missing test module');
  process.exit(1);
}
http.createServer((req, res) => {
  res.setHeader('Content-Type', 'application/json');
  if (mode === 'unready') res.writeHead(503);
  res.end(JSON.stringify({ status: 'ok', ...(mode === 'foreign' ? {} : {session_store: 'memory'}) }));
}).listen(port, '127.0.0.1');
