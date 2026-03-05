# SSL Certificates

Place your SSL certificates here:

- `privkey.pem` - Private key
- `fullchain.pem` - Certificate chain

## Development

Run `./generate-certs.sh` to generate self-signed certificates for local development.

## Production

For production, use certificates from:
- [Let's Encrypt](https://letsencrypt.org/) (free)
- Your certificate authority
- Cloud provider (AWS ACM, Google Cloud SSL, etc.)

### Let's Encrypt Example

```bash
# Install certbot
sudo apt install certbot

# Get certificate (replace with your domain)
sudo certbot certonly --standalone -d your-domain.com

# Copy certificates
sudo cp /etc/letsencrypt/live/your-domain.com/privkey.pem ./privkey.pem
sudo cp /etc/letsencrypt/live/your-domain.com/fullchain.pem ./fullchain.pem
```
