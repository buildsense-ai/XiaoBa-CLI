#!/bin/bash
# Test script for CatsCompany Bot messaging

API_BASE="http://localhost:6061"
BOT_UID=9
TEST_USER_ID=7

# Login as testuser to get token
echo "=== 1. Login as testuser ==="
LOGIN_RESPONSE=$(curl -s -X POST "$API_BASE/api/auth/login" \
  -H "Content-Type: application/json" \
  -d '{"username":"testuser","password":"test123"}')
echo "$LOGIN_RESPONSE"

TOKEN=$(echo "$LOGIN_RESPONSE" | grep -o '"token":"[^"]*"' | cut -d'"' -f4)
echo "Token: ${TOKEN:0:20}..."

if [ -z "$TOKEN" ]; then
  echo "ERROR: Failed to get token"
  exit 1
fi

# Get P2P topic ID (format: p2p_{smaller}_{larger})
if [ $TEST_USER_ID -lt $BOT_UID ]; then
  TOPIC="p2p_${TEST_USER_ID}_${BOT_UID}"
else
  TOPIC="p2p_${BOT_UID}_${TEST_USER_ID}"
fi
echo ""
echo "=== 2. Topic: $TOPIC ==="

# Send a test message via WebSocket
echo ""
echo "=== 3. Sending message via WebSocket ==="
# Use websocat if available, otherwise use node
if command -v websocat &> /dev/null; then
  echo "Using websocat..."
  echo '{"pub":{"id":"test1","topic":"'"$TOPIC"'","content":"你好 Xiaoba，这是一条测试消息！"}}' | \
    timeout 5 websocat "ws://localhost:6061/v0/channels?token=$TOKEN" 2>&1 || true
else
  echo "Using node WebSocket client..."
  node -e "
    const WebSocket = require('ws');
    const ws = new WebSocket('ws://localhost:6061/v0/channels?token=$TOKEN');

    ws.on('open', () => {
      console.log('WebSocket connected');

      // Send handshake
      ws.send(JSON.stringify({hi: {id: 'hi1', ver: '0.1.0'}}));

      // Wait a bit then send message
      setTimeout(() => {
        const msg = {
          pub: {
            id: 'msg1',
            topic: '$TOPIC',
            content: '你好 Xiaoba，这是一条测试消息！'
          }
        };
        console.log('Sending:', JSON.stringify(msg));
        ws.send(JSON.stringify(msg));
      }, 1000);

      // Wait for responses
      setTimeout(() => {
        console.log('Closing...');
        ws.close();
        process.exit(0);
      }, 5000);
    });

    ws.on('message', (data) => {
      console.log('Received:', data.toString());
    });

    ws.on('error', (err) => {
      console.error('WebSocket error:', err.message);
    });
  " 2>&1
fi

echo ""
echo "=== 4. Test complete ==="
