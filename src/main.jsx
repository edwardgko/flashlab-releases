import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.jsx'
import LoginGate from './components/LoginGate.jsx'
import { useTheme } from './lib/useTheme.js'

// useTheme() vive acá arriba (no dentro de <App/>) para que la clase `dark`
// en <html> quede aplicada desde el arranque — LoginGate ya tiene estilos
// dark: escritos, pero sin esto nunca se activaban porque <App/> (quien
// llamaba a useTheme antes) no llega a montar hasta después del login.
function Root() {
  const { theme, setTheme } = useTheme()
  return (
    <LoginGate>
      <App theme={theme} setTheme={setTheme} />
    </LoginGate>
  )
}

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <Root />
  </StrictMode>,
)
