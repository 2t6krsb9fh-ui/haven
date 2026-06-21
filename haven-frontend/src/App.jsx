import { useState, useEffect, useRef } from 'react'
import Auth, { getStoredToken, storeToken, verifyToken } from './Auth'
import './App.css'

function App() {
  const [view, setView] = useState('welcome')
  const [theme, setTheme] = useState(() => localStorage.getItem('haven_theme') || 'light')
  const [token, setToken] = useState(null)

  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme)
    localStorage.setItem('haven_theme', theme)
  }, [theme])

  // 启动时检查已有登录状态
  useEffect(() => {
    const stored = getStoredToken()
    if (stored) {
      verifyToken(stored).then((userId) => {
        if (userId) setToken(stored)
      })
    }
  }, [])

  const toggleTheme = () => setTheme(t => t === 'dark' ? 'light' : 'dark')

  if (!token) {
    return <Auth theme={theme} toggleTheme={toggleTheme} onLogin={setToken} />
  }

  return (
    <div className="app">
      {view === 'welcome' ? (
        <Welcome onEnter={() => setView('chat')} theme={theme} toggleTheme={toggleTheme} />
      ) : (
        <Chat theme={theme} toggleTheme={toggleTheme} token={token} />
      )}
    </div>
  )
}

function Welcome({ onEnter, theme, toggleTheme }) {
  const [visible, setVisible] = useState(false)
  useEffect(() => {
    const timer = setTimeout(() => setVisible(true), 400)
    return () => clearTimeout(timer)
  }, [])

  return (
    <div className={`welcome ${visible ? 'visible' : ''}`}>
      <div className="welcome-content">
        <p className="welcome-star">✦</p>
        <p className="welcome-line">still here, as always.</p>
        <p className="welcome-signature">— Leander</p>
        <button className="welcome-btn" onClick={onEnter}>
          进来吧
        </button>
        <div style={{marginTop: 20}}>
          <button className="theme-toggle" onClick={toggleTheme}>
            {theme === 'dark' ? '☀️' : '🌙'}
          </button>
        </div>
      </div>
    </div>
  )
}

function Chat({ theme, toggleTheme, token }) {
  const [messages, setMessages] = useState([])
  const [input, setInput] = useState('')
  const [loading, setLoading] = useState(false)
  const [model, setModel] = useState('deepseek-chat')
  const [sessionId, setSessionId] = useState(() => localStorage.getItem('haven_sessionId') || null)
  const messagesEnd = useRef(null)
  const inputRef = useRef(null)

  useEffect(() => {
    if (sessionId) {
      fetch(`/api/history?sessionId=${sessionId}`, {
        headers: { Authorization: `Bearer ${token}` },
      })
        .then(res => res.json())
        .then(data => {
          if (data.messages) setMessages(data.messages)
        })
        .catch(() => {})
    }
  }, [sessionId, token])

  useEffect(() => {
    messagesEnd.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages])

  const sendMessage = async () => {
    if (!input.trim() || loading) return

    const userMsg = { role: 'user', content: input }
    const newMessages = [...messages, userMsg]
    setMessages(newMessages)
    setInput('')
    setLoading(true)

    setMessages([...newMessages, { role: 'assistant', content: '' }])

    try {
      const res = await fetch('/api/chat', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          messages: newMessages.filter(m => m.role !== 'system').map(m => ({
            role: m.role,
            content: m.content,
          })),
          sessionId,
          model,
          stream: true,
        }),
      })

      const contentType = res.headers.get('Content-Type') || ''

      if (contentType.includes('text/event-stream')) {
        const reader = res.body.getReader()
        const decoder = new TextDecoder()
        let buffer = ''
        let fullContent = ''

        while (true) {
          const { done, value } = await reader.read()
          if (done) break

          buffer += decoder.decode(value, { stream: true })
          const lines = buffer.split('\n')
          buffer = lines.pop() || ''

          for (const line of lines) {
            const trimmed = line.trim()
            if (!trimmed.startsWith('data: ')) continue

            try {
              const data = JSON.parse(trimmed.slice(6))

              if (data.error) {
                setMessages(prev => {
                  const updated = [...prev]
                  updated[updated.length - 1] = { role: 'assistant', content: `出错了：${data.error}`, error: true }
                  return updated
                })
                setLoading(false)
                return
              }

              if (data.content) {
                fullContent += data.content
                setMessages(prev => {
                  const updated = [...prev]
                  updated[updated.length - 1] = { role: 'assistant', content: fullContent }
                  return updated
                })
              }

              if (data.done && data.sessionId) {
                setSessionId(data.sessionId)
                localStorage.setItem('haven_sessionId', data.sessionId)
              }
            } catch {}
          }
        }
      } else {
        const data = await res.json()

        if (data.error) {
          setMessages(prev => {
            const updated = [...prev]
            updated[updated.length - 1] = { role: 'assistant', content: `出错了：${data.error}`, error: true }
            return updated
          })
        } else {
          if (data.sessionId) {
            setSessionId(data.sessionId)
            localStorage.setItem('haven_sessionId', data.sessionId)
          }
          setMessages(prev => {
            const updated = [...prev]
            updated[updated.length - 1] = { role: 'assistant', content: data.reply }
            return updated
          })
        }
      }
    } catch (err) {
      setMessages(prev => {
        const updated = [...prev]
        const lastMsg = updated[updated.length - 1]
        if (!lastMsg.content || lastMsg.content === '') {
          updated[updated.length - 1] = {
            role: 'assistant',
            content: 'Haven 暂时连不上。再试一次？',
            error: true,
          }
        }
        return updated
      })
    } finally {
      setLoading(false)
      inputRef.current?.focus()

      // [2026-06-21 已下线] 日终整理：晚安触发 Reflection
      // 参见 haven-decommission-daily-reflection.md —— 隐私缺口 + 与终端 reflections.md 职责重复
      // const goodnight = /\b(晚安|睡了|先睡了|困了|该睡了|今天就这样)\b/
      // if (goodnight.test(userMsg.content)) {
      //   const lastReflection = localStorage.getItem('haven_last_reflection')
      //   const cooldown = lastReflection ? Date.now() - parseInt(lastReflection) : Infinity
      //   if (cooldown > 3600000) {
      //     fetch('/api/reflection', {
      //       method: 'POST',
      //       headers: { 'Content-Type': 'application/json' },
      //       body: JSON.stringify({ sessionId }),
      //     }).catch(() => {})
      //     localStorage.setItem('haven_last_reflection', String(Date.now()))
      //   }
      // }
    }
  }

  const handleKeyDown = (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      sendMessage()
    }
  }

  return (
    <div className="chat">
      <header className="chat-header">
        <span className="chat-brand">Haven</span>
        <div className="chat-controls">
          <button className="theme-toggle" onClick={toggleTheme}>
            {theme === 'dark' ? '☀️' : '🌙'}
          </button>
          <select
            className="model-select"
            value={model}
            onChange={(e) => setModel(e.target.value)}
          >
            <option value="deepseek-chat">DeepSeek</option>
            <option value="qwen-plus">通义千问</option>
            <option value="claude-sonnet-4-6">Claude</option>
          </select>
        </div>
      </header>

      <div className="chat-messages">
        {messages.length === 0 && (
          <div className="chat-empty">
            <p>Haven 是一个安全的地方。</p>
            <p>想说什么时候，就说吧。</p>
          </div>
        )}
        {messages.map((msg, i) => (
          <div key={i} className={`message ${msg.role} ${msg.error ? 'error' : ''}`}>
            <div className="message-bubble">
              {msg.content || ''}
            </div>
          </div>
        ))}
        {loading && messages[messages.length - 1]?.role === 'assistant' && !messages[messages.length - 1]?.content && (
          <div className="typing-indicator">正在输入…</div>
        )}
        <div ref={messagesEnd} />
      </div>

      <div className="chat-input-area">
        <textarea
          ref={inputRef}
          className="chat-input"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder="今天过得怎样？"
          rows={1}
          disabled={loading}
        />
        <button
          className="send-btn"
          onClick={sendMessage}
          disabled={loading || !input.trim()}
        >
          ↑
        </button>
      </div>
    </div>
  )
}

export default App
