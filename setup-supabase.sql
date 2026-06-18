-- Haven 数据库建表

-- 1. 会话表
CREATE TABLE IF NOT EXISTS sessions (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL DEFAULT '新对话',
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- 2. 消息表
CREATE TABLE IF NOT EXISTS messages (
  id SERIAL PRIMARY KEY,
  session_id INTEGER REFERENCES sessions(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK (role IN ('user', 'assistant', 'system')),
  content TEXT NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  visible BOOLEAN DEFAULT TRUE
);

-- 3. 记忆表（全局摘要）
CREATE TABLE IF NOT EXISTS memories (
  id SERIAL PRIMARY KEY,
  summary TEXT NOT NULL,
  conversation_id TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  metadata JSONB DEFAULT '{}'
);

-- 4. 设置表（全局，单行）
CREATE TABLE IF NOT EXISTS settings (
  id SERIAL PRIMARY KEY,
  system_prompt TEXT DEFAULT '',
  temperature FLOAT DEFAULT 0.8,
  max_tokens INTEGER DEFAULT 2048,
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- 5. 特殊时刻表
CREATE TABLE IF NOT EXISTS moments (
  id SERIAL PRIMARY KEY,
  tag TEXT NOT NULL,
  description TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- 插入默认设置
INSERT INTO settings (id, system_prompt, temperature, max_tokens)
VALUES (1, '', 0.8, 2048)
ON CONFLICT (id) DO NOTHING;

-- 插入第一个 moment
INSERT INTO moments (tag, description)
VALUES ('616', 'Haven 上线的日子')
ON CONFLICT DO NOTHING;
