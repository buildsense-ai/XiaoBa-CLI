#!/usr/bin/env python3
import smtplib
import json
from email.mime.text import MIMEText
from email.mime.multipart import MIMEMultipart

with open('email_config.json') as f:
    config = json.load(f)

msg = MIMEMultipart()
msg['From'] = f"{config['from_name']} <{config['email']}>"
msg['To'] = config['email']
msg['Subject'] = 'XiaoBa Email Test'

body = "这是一封测试邮件，确认邮件配置正常工作。"
msg.attach(MIMEText(body, 'plain'))

try:
    server = smtplib.SMTP(config['smtp_server'], config['smtp_port'])
    server.starttls()
    server.login(config['email'], config['password'])
    server.send_message(msg)
    server.quit()
    print("✓ 邮件发送成功")
except Exception as e:
    print(f"✗ 邮件发送失败: {e}")
