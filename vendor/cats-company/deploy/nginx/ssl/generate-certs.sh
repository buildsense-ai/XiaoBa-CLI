#!/bin/bash
# Generate self-signed SSL certificates for development
# For production, use Let's Encrypt or your own certificates

set -e

SSL_DIR="$(dirname "$0")"
cd "$SSL_DIR"

# Generate private key and self-signed certificate
openssl req -x509 -nodes -days 365 -newkey rsa:2048 \
  -keyout privkey.pem \
  -out fullchain.pem \
  -subj "/C=CN/ST=Beijing/L=Beijing/O=CatsCompany/OU=Dev/CN=localhost" \
  -addext "subjectAltName=DNS:localhost,IP:127.0.0.1"

echo "Generated self-signed certificates:"
echo "  - privkey.pem (private key)"
echo "  - fullchain.pem (certificate)"
echo ""
echo "For production, replace these with real certificates from Let's Encrypt."
