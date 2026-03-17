#!/usr/bin/env python3
"""
蛋白质结构预测演示流程
1. 接收邮件中的蛋白质序列
2. 使用ESMFold预测结构
3. 生成3D可视化
4. 发送结果报告
"""
import json
import smtplib
from email.mime.text import MIMEText
from email.mime.multipart import MIMEMultipart
from email.mime.base import MIMEBase
from email import encoders
import requests
import os

# 加载邮件配置
with open('email_config.json') as f:
    email_config = json.load(f)

def send_email(to_email, subject, body, attachment_path=None):
    """发送邮件"""
    msg = MIMEMultipart()
    msg['From'] = f"{email_config['from_name']} <{email_config['email']}>"
    msg['To'] = to_email
    msg['Subject'] = subject
    msg.attach(MIMEText(body, 'plain'))
    
    if attachment_path and os.path.exists(attachment_path):
        with open(attachment_path, 'rb') as f:
            part = MIMEBase('application', 'octet-stream')
            part.set_payload(f.read())
            encoders.encode_base64(part)
            part.add_header('Content-Disposition', f'attachment; filename={os.path.basename(attachment_path)}')
            msg.attach(part)
    
    server = smtplib.SMTP(email_config['smtp_server'], email_config['smtp_port'])
    server.starttls()
    server.login(email_config['email'], email_config['password'])
    server.send_message(msg)
    server.quit()

def predict_structure(sequence):
    """使用ESMFold预测蛋白质结构"""
    print(f"预测序列: {sequence[:50]}...")
    url = "https://api.esmatlas.com/foldSequence/v1/pdb/"
    response = requests.post(url, data=sequence, headers={'Content-Type': 'text/plain'})
    
    if response.status_code == 200:
        pdb_file = 'predicted_structure.pdb'
        with open(pdb_file, 'w') as f:
            f.write(response.text)
        print(f"✓ 结构预测完成: {pdb_file}")
        return pdb_file
    else:
        raise Exception(f"预测失败: {response.status_code}")

def generate_visualization(pdb_file):
    """生成3D可视化HTML"""
    html_content = f"""<!DOCTYPE html>
<html>
<head>
    <title>蛋白质结构可视化</title>
    <script src="https://3Dmol.csb.pitt.edu/build/3Dmol-min.js"></script>
</head>
<body>
    <div id="viewer" style="width:800px;height:600px;"></div>
    <script>
        let viewer = $3Dmol.createViewer("viewer");
        let pdbData = `{open(pdb_file).read()}`;
        viewer.addModel(pdbData, "pdb");
        viewer.setStyle({{}}, {{cartoon: {{color: 'spectrum'}}}});
        viewer.zoomTo();
        viewer.render();
    </script>
</body>
</html>"""
    
    html_file = 'structure_visualization.html'
    with open(html_file, 'w') as f:
        f.write(html_content)
    print(f"✓ 可视化生成: {html_file}")
    return html_file

def main():
    # 演示序列（胰岛素A链）
    sequence = "GIVEQCCTSICSLYQLENYCN"
    recipient = email_config['email']
    
    print("=== 蛋白质结构预测演示 ===\n")
    
    # 步骤1: 预测结构
    pdb_file = predict_structure(sequence)
    
    # 步骤2: 生成可视化
    html_file = generate_visualization(pdb_file)
    
    # 步骤3: 发送报告
    report = f"""蛋白质结构预测完成

序列: {sequence}
长度: {len(sequence)} 氨基酸

预测结果已附件，请下载HTML文件在浏览器中查看3D结构。

---
XiaoBa 自动生成"""
    
    send_email(recipient, "蛋白质结构预测报告", report, html_file)
    print(f"\n✓ 报告已发送至: {recipient}")

if __name__ == "__main__":
    main()
