import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// 移除生产构建中的 crossorigin 属性（国内移动网络兼容性）
function removeCrossorigin() {
  return {
    name: 'remove-crossorigin',
    transformIndexHtml(html) {
      return html.replace(/crossorigin/g, '')
    },
  }
}

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), removeCrossorigin()],
})
