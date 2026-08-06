import tls from 'tls';

const domain = 'fast-horse.pipe-oneshot.com';
const cfIp = '104.21.81.121';

console.log(`Connecting to Cloudflare IP ${cfIp} with SNI ${domain}...`);

const socket = tls.connect({
  host: cfIp,
  port: 443,
  servername: domain,
  rejectUnauthorized: false
}, () => {
  console.log('✅ TLS HANDSHAKE SUCCESS!');
  console.log('Protocol:', socket.getProtocol());
  console.log('Peer Certificate:', socket.getPeerCertificate()?.subject);
  socket.write(`GET /1.html HTTP/1.1\r\nHost: ${domain}\r\nUser-Agent: Mozilla/5.0\r\nConnection: close\r\n\r\n`);
});

socket.on('data', (d) => {
  console.log('HTTP DATA RESPONSE:', d.toString().slice(0, 300));
});

socket.on('error', (e) => {
  console.log('❌ TLS HANDSHAKE ERROR:', e);
});
