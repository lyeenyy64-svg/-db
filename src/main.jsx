import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App.jsx'

// 화면 어딘가에서 처리되지 않은 오류가 나면 리액트가 화면 전체를 그냥 빈 백지로
// 지워버린다("먹통"처럼 보임) — 에러 바운더리가 없었기 때문. 대신 원인을 알 수 있는
// 안내 화면 + 새로고침 버튼을 보여줘서, 다음에 같은 문제가 또 생기면 무슨 오류인지
// 바로 알 수 있게 한다.
class ErrorBoundary extends React.Component {
  constructor(props) {
    super(props)
    this.state = { error: null }
  }
  static getDerivedStateFromError(error) {
    return { error }
  }
  componentDidCatch(error, info) {
    console.error('[ErrorBoundary]', error, info)
  }
  render() {
    if (this.state.error) {
      return (
        <div style={{ padding: 40, fontFamily: 'sans-serif', maxWidth: 700, margin: '60px auto', textAlign: 'center' }}>
          <div style={{ fontSize: 18, fontWeight: 700, marginBottom: 12 }}>화면에 오류가 발생했습니다</div>
          <div style={{ fontSize: 13, color: '#666', marginBottom: 20 }}>
            새로고침하면 대부분 정상으로 돌아옵니다. 계속 반복되면 이 오류 내용을 캡처해서 알려주세요.
          </div>
          <button onClick={() => window.location.reload()}
            style={{ padding: '8px 20px', borderRadius: 8, background: '#111827', color: '#fff', border: 'none', cursor: 'pointer', fontSize: 14, marginBottom: 20 }}>
            새로고침
          </button>
          <pre style={{ textAlign: 'left', background: '#f3f4f6', padding: 14, borderRadius: 8, fontSize: 11, color: '#b91c1c', overflow: 'auto', whiteSpace: 'pre-wrap' }}>
            {String(this.state.error && (this.state.error.stack || this.state.error.message || this.state.error))}
          </pre>
        </div>
      )
    }
    return this.props.children
  }
}

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </React.StrictMode>,
)
