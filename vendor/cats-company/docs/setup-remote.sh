#!/bin/bash
# Setup docs server as systemd service

# Create systemd service file
cat > /etc/systemd/system/cc-docs.service << 'EOF'
[Unit]
Description=CatsCompany API Docs
After=network.target

[Service]
Type=simple
WorkingDirectory=/root/docs
ExecStart=/usr/bin/python3 /root/docs/serve.py
Restart=always
RestartSec=3

[Install]
WantedBy=multi-user.target
EOF

# Enable and start
systemctl daemon-reload
systemctl enable cc-docs
systemctl start cc-docs

# Check port 9090 firewall
iptables -C INPUT -p tcp --dport 9090 -j ACCEPT 2>/dev/null || iptables -A INPUT -p tcp --dport 9090 -j ACCEPT

# Verify
sleep 1
curl -s -o /dev/null -w '%{http_code}' http://localhost:9090/docs
echo ""
echo "DONE"
