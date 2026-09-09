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
  // Sep 9, 2026: a sign-up no longer establishes a session.
  //
  // The endpoint used to return a token like a login does, and this called
  // establishSession with it. It now creates the account with
  // approval_status 'pending' and returns NO token, because that is the point
  // of admin approval — an account that could place orders the moment it was
  // created would have nothing to approve.
  //
  // Returns the response payload (user + message) so the page can say what
  // happens next instead of navigating into an app the caller cannot use.
  const signup = async (fields) => {
    const { data } = await client.post('/api/auth/register', fields);
    if (data.success) return data.data;
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

  // Sep 5, 2026: Profile Settings needs to update what the rest of the app
  // (Topbar's name/role display, the New Order form's Salesperson/Division
  // fields) sees immediately after a save, without a full page reload.
  // Re-fetching /me rather than trusting the profile-save response's user
  // object keeps this the single source of truth for "what does the session
  // currently look like" — the same call the initial-load effect above uses.
  const refreshUser = async () => {
    const { data } = await client.get('/api/auth/me');
    setUser(data.data.user);
    return data.data.user;
  };

  return (
    <AuthContext.Provider value={{ user, token, login, signup, quickLogin, logout, refreshUser, isLoading }}>
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
