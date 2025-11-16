/**
 * Quick test script for Igris MCP Server
 * Tests the server can start and list tools
 */

import { spawn } from 'child_process';

console.log('🔥 Testing Igris MCP Server...\n');

const server = spawn('node', ['dist/index.js'], {
  cwd: process.cwd(),
});

let output = '';

server.stdout.on('data', (data) => {
  output += data.toString();
  console.log('📥 Server stdout:', data.toString());
});

server.stderr.on('data', (data) => {
  console.log('📢 Server stderr:', data.toString());
});

// Send a ListTools request after 1 second
setTimeout(() => {
  console.log('\n🎯 Sending ListTools request...\n');

  const request = {
    jsonrpc: '2.0',
    id: 1,
    method: 'tools/list',
    params: {}
  };

  server.stdin.write(JSON.stringify(request) + '\n');

  // Give it 2 seconds to respond, then exit
  setTimeout(() => {
    console.log('\n✅ Test complete! Server responded.\n');
    server.kill();
    process.exit(0);
  }, 2000);
}, 1000);

server.on('error', (error) => {
  console.error('❌ Server error:', error);
  process.exit(1);
});

server.on('exit', (code) => {
  console.log(`\nServer exited with code ${code}`);
});
