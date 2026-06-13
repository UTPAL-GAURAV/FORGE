import { Routes, Route, Navigate } from 'react-router-dom'
import { AuthProvider, useAuth } from './context/AuthContext'
import Landing from './pages/Landing'
import Dashboard from './pages/Dashboard'
import SessionRunner from './pages/SessionRunner'
import Debrief from './pages/Debrief'

function ProtectedRoute({ children }) {
  const { user } = useAuth()
  if (user === undefined) return <div className="loading-screen" />
  if (!user) return <Navigate to="/" replace />
  return children
}

function AppRoutes() {
  const { user } = useAuth()
  return (
    <Routes>
      <Route path="/" element={<Landing />} />
      <Route path="/dashboard" element={
        <ProtectedRoute><Dashboard /></ProtectedRoute>
      } />
      <Route path="/session/:id" element={
        <ProtectedRoute><SessionRunner /></ProtectedRoute>
      } />
      <Route path="/session/:id/debrief" element={
        <ProtectedRoute><Debrief /></ProtectedRoute>
      } />
    </Routes>
  )
}

export default function App() {
  return (
    <AuthProvider>
      <AppRoutes />
    </AuthProvider>
  )
}
