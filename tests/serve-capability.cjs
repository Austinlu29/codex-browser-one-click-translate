const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
http.createServer((request, response) => {
  if (request.url === '/local-translator.js' || request.url === '/content.js') {
    response.writeHead(200, { 'Content-Type': 'application/javascript; charset=utf-8', 'Cache-Control': 'no-store' });
    response.end(fs.readFileSync(path.join(__dirname, '../page-translator', request.url.slice(1)))); return;
  }
  if (request.url === '/demo') {
    response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
    response.end(fs.readFileSync(path.join(__dirname, 'local-demo.html'))); return;
  }
  if (request.url !== '/') { response.writeHead(404).end(); return; }
  response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
  response.end(fs.readFileSync(path.join(__dirname, 'local-capability.html')));
}).listen(8766, '127.0.0.1', () => console.log('Capability check: http://127.0.0.1:8766/'));
