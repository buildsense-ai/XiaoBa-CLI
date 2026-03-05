#!/bin/bash
# Comprehensive bot test script

API_BASE="http://localhost:6061"

# Login
echo "=== Login ==="
RESP=$(curl -s -X POST "$API_BASE/api/auth/login" \
  -H "Content-Type: application/json" \
  -d '{"username":"testuser","password":"test123"}')
TOKEN=$(echo "$RESP" | grep -o '"token":"[^"]*"' | cut -d'"' -f4)
echo "Token: ${TOKEN:0:20}..."

# Test messages
test_p2p_messages() {
  echo ""
  echo "=== Test $1: $2 ==="
  node -e "
    const WebSocket = require('ws');
    const ws = new WebSocket('ws://localhost:6061/v0/channels?token=$TOKEN');

    ws.on('open', () => {
      ws.send(JSON.stringify({hi: {id: 'hi1', ver: '0.1.0'}}));
      setTimeout(() => {
        ws.send(JSON.stringify({pub: {id: 'msg$1', topic: 'p2p_7_9', content: '$2'}}));
      }, 500);
      setTimeout(() => { ws.close(); process.exit(0); }, 10000);
    });
    ws.on('message', (d) => {
      const msg = JSON.parse(d.toString());
      if (msg.data && msg.data.from === 'usr9') {
        console.log('Bot回复:', msg.data.content);
      }
    });
  " 2>&1
  sleep 3
}

# Run tests
test_p2p_messages 1 "你好，请问你是谁？"
test_p2p_messages 2 "帮我查一下今天的日期"
test_p2p_messages 3 "你有什么技能？"
test_p2p_messages 4 "用 Python 写一个 hello world"

echo ""
echo "=== All tests complete ==="
