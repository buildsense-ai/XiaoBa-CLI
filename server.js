const express = require('express');
const mysql = require('mysql2/promise');
const bcrypt = require('bcryptjs');
const validator = require('validator');

const app = express();
app.use(express.json());

// 数据库连接池
const pool = mysql.createPool({
  host: 'localhost',
  user: 'root',
  password: 'password',
  database: 'app',
  waitForConnections: true,
  connectionLimit: 10,
});

// 用户注册
app.post('/api/register', async (req, res) => {
  try {
    const { username, email, password } = req.body;

    // 1. 参数校验
    if (!username || !email || !password) {
      return res.status(400).json({ error: '用户名、邮箱、密码不能为空' });
    }
    if (!validator.isEmail(email)) {
      return res.status(400).json({ error: '邮箱格式无效' });
    }
    if (password.length < 8) {
      return res.status(400).json({ error: '密码至少8位' });
    }

    // 2. 检查用户是否已存在
    const [existing] = await pool.execute(
      'SELECT id FROM users WHERE email = ? OR username = ?',
      [email, username]
    );
    if (existing.length > 0) {
      return res.status(409).json({ error: '用户已存在' });
    }

    // 3. 密码加密
    const hashedPassword = await bcrypt.hash(password, 12);

    // 4. 插入数据库
    const [result] = await pool.execute(
      'INSERT INTO users (username, email, password) VALUES (?, ?, ?)',
      [username, email, hashedPassword]
    );

    res.status(201).json({
      message: '注册成功',
      userId: result.insertId
    });

  } catch (error) {
    console.error('注册失败:', error);
    res.status(500).json({ error: '服务器错误' });
  }
});

// 密码校验（登录时用）
async function verifyPassword(inputPassword, hashedPassword) {
  return await bcrypt.compare(inputPassword, hashedPassword);
}

app.listen(3000, () => {
  console.log('服务运行在 http://localhost:3000');
});
