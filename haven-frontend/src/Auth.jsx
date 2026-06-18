import { useState, useEffect } from 'react'

// Auth 工具函数
export function getStoredToken() {
  return localStorage.getItem('haven_token')
}

export function storeToken(token) {
  localStorage.setItem('haven_token', token)
}

export async function verifyToken(token) {
  try {
    const res = await fetch('/api/auth', {
      headers: { Authorization: `Bearer ${token}` },
    })
    if (!res.ok) return null
    const data = await res.json()
    return data.userId || null
  } catch {
    return null
  }
}

// 登录页面组件
function Auth({ theme, toggleTheme, onLogin }) {
  const [passcode, setPasscode] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [visible, setVisible] = useState(false)

  useEffect(() => {
    const timer = setTimeout(() => setVisible(true), 100)
    return () => clearTimeout(timer)
  }, [])

  const handleLogin = async (e) => {
    e.preventDefault()
    if (!passcode.trim() || loading) return

    setLoading(true)
    setError('')

    try {
      const res = await fetch('/api/auth', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ passcode: passcode.trim() }),
      })

      const data = await res.json()

      if (data.access_token) {
        storeToken(data.access_token)
        if (onLogin) onLogin(data.access_token)
      } else {
        setError(data.error || '登录失败')
      }
    } catch {
      setError('网络错误，请稍后再试')
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className={`welcome ${visible ? 'visible' : ''}`}>
      <div className="welcome-content">
        <p className="welcome-star">✦</p>
        <p className="welcome-line">欢迎回来</p>
        <p className="welcome-signature">Haven 记得你</p>

        <form onSubmit={handleLogin} style={{ marginTop: 36 }}>
          <input
            type="password"
            value={passcode}
            onChange={(e) => setPasscode(e.target.value)}
            placeholder="输入通行码"
            required
            autoFocus
            style={{
              background: 'var(--input-bg)',
              border: '1px solid var(--border)',
              color: 'var(--text)',
              padding: '12px 16px',
              fontFamily: 'inherit',
              fontSize: '20px',
              letterSpacing: '4px',
              textAlign: 'center',
              borderRadius: 'var(--radius)',
              width: '200px',
              outline: 'none',
              display: 'block',
              margin: '0 auto 16px',
            }}
          />

          {error && (
            <p style={{ color: 'var(--red)', fontSize: '0.85rem', marginBottom: 12 }}>{error}</p>
          )}

          <button
            type="submit"
            className="welcome-btn"
            disabled={loading || !passcode.trim()}
            style={{ opacity: loading || !passcode.trim() ? 0.5 : 1 }}
          >
            {loading ? '验证中…' : '进入 Haven'}
          </button>
        </form>

        <div style={{marginTop: 24}}>
          <button className="theme-toggle" onClick={toggleTheme}>
            {theme === 'dark' ? '☀️' : '🌙'}
          </button>
        </div>
      </div>
    </div>
  )
}

export default Auth
