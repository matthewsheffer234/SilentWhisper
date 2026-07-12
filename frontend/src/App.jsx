import { useAuth } from './context/AuthContext.jsx';
import LoginScreen from './components/LoginScreen.jsx';
import ChatShell from './components/ChatShell.jsx';

export default function App() {
  const { status } = useAuth();

  if (status === 'loading') {
    return (
      <div
        style={{
          display: 'flex',
          minHeight: '100vh',
          alignItems: 'center',
          justifyContent: 'center',
          background: 'var(--surface)',
          color: 'var(--text-3)',
          fontFamily: 'var(--font-sans)',
        }}
      >
        Loading…
      </div>
    );
  }

  return status === 'authenticated' ? <ChatShell /> : <LoginScreen />;
}
