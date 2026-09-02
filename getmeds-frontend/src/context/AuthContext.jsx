import React, { createContext, useState, useEffect, useContext } from 'react';
import client from '../api/client';

export const AuthContext = createContext();

export const AuthProvider = ({ children }) => {
  const [user, setUser] = useState(null);
  // sessionStorage, not localStorage: each browser tab gets its own isolated
  // token, so several tabs (one per role, e.g. for a live demo) can each stay
  // logged in as a different user at the same time instead of sharing one
  // login across every tab of the browser.
  const [token, setToken] = useState(sessionStorage.getItem('token'));
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    const fetchUser = async () => {
      if (!token) {
        setIsLoading(false);
        return;
      }
      try {
        const { data } = await client.get('/api/auth/me');
        setUser(data.data.user);
      } catch (error) {
        console.error('Failed to fetch user', error);
        logout();
      } finally {
        setIsLoading(false);
      }
    };
    fetchUser();
  }, [token]);

  // Shared by login/signup/quickLogin: all three return the same
  // { token, user } payload, so the session is established the same way.
  const establishSession = (data) => {
    const { token: newToken, user: userData } = data;
    sessionStorage.setItem('token', newToken);
    setToken(newToken);
    setUser(userData);
    return userData;
  };

  const login = async (email, password) => {
    const { data } = await client.post('/api/auth/login', { email, password });
    if (data.success) return establishSession(data.data);
    throw new Error('Login failed');
  };

  // Sep 2, 2026. Self-service sign-up. Takes the whole form as one object —
  // first/middle/last, display_name, division, sub_division, email, password.
  //
  // Two fields are deliberately NOT parameters here:
  //   role        — the backend hard-codes every sign-up to medrep and
  //                 ignores a role sent by the client.
  //   salesperson — a generated column in the database, always
  //                 "<division> | <display name>". The form shows it as a
  //                 preview; sending it would imply the client decides it.
  // A successful sign-up returns a token exactly like a login, so the new
  // user lands straight in the app.
  const signup = async (fields) => {
    const { data } = await client.post('/api/auth/register', fields);
    if (data.success) return establishSession(data.data);
    throw new Error('Sign up failed');
  };

  const quickLogin = async (target) => {
    const payload = typeof target === 'string' ? { email: target } : target;
    const { data } = await client.post('/api/test/quick-login', payload);
    if (data.success) return establishSession(data.data);
    throw new Error('Quick login failed');
  };

  const logout = () => {
    sessionStorage.removeItem('token');
    setToken(null);
    setUser(null);
  };

  return (
    <AuthContext.Provider value={{ user, token, login, signup, quickLogin, logout, isLoading }}>
      {children}
    </AuthContext.Provider>
  );
};

// ADD THIS EXPORT:
export const useAuth = () => {
  const context = useContext(AuthContext);
  if (!context) {
    throw new Error('useAuth must be used within an AuthProvider');
  }
  return context;
};
