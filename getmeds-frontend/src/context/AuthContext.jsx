import React, { createContext, useState, useEffect, useContext } from 'react';
import client from '../api/client';
import toast from 'react-hot-toast';

export const AuthContext = createContext();

export const AuthProvider = ({ children }) => {
  const [user, setUser] = useState(null);
  const [token, setToken] = useState(localStorage.getItem('token'));
  const [isLoading, setIsLoading] = useState(true);
  // Oct 2, 2026: true while the server could not be reached to check the saved
  // login. The session is kept and the check is retried — see below.
  const [connectionError, setConnectionError] = useState(false);

  useEffect(() => {
    if (!token) {
      setIsLoading(false);
      return undefined;
    }

    let cancelled = false;
    let timer;

    // Oct 2, 2026: any failure here used to call logout(), so a brief database
    // problem or a dropped connection at page load signed the person out.
    // Only the server saying the login itself is invalid (401) does that now.
    // Anything else — no connection, 503, a timeout — keeps the saved login and
    // tries again, with the screen saying so (see SessionLoading in App.jsx).
    const fetchUser = async (attempt = 0) => {
      try {
        const { data } = await client.get('/api/auth/me');
        if (cancelled) return;
        setUser(data.data.user);
        setConnectionError(false);
        setIsLoading(false);
      } catch (error) {
        if (cancelled) return;
        if (error.response?.status === 401) {
          logout();
          setIsLoading(false);
          return;
        }
        console.error('Could not check the saved login, will retry', error.message);
        setConnectionError(true);
        timer = setTimeout(() => fetchUser(attempt + 1), Math.min(3000 * (attempt + 1), 15000));
      }
    };
    fetchUser();

    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [token]);

  /**
   * Sep 12, 2026: notice when this account's role changes underneath us.
   *
   * The effect above runs only when the TOKEN changes — on login, or a full
   * page load. So an admin changing someone's role reached the server
   * immediately (requireAuth re-reads the user on every request) but never
   * reached that person's open tab: their badge, their navigation and every
   * route guard kept using the role they had when they signed in.
   *
   * The visible symptom was an admin changing a role, watching nothing happen,
   * and changing it again. The database was right the whole time.
   *
   * Checked on focus rather than only on a timer, because the realistic
   * sequence is someone being told "I've changed your role" and switching back
   * to the tab. The interval is the backstop for a tab left open all day.
   *
   * Deliberately does NOT log out on failure: a transient network error is not
   * a revoked session, and signing someone out mid-order to be safe is worse
   * than being a minute late to a role change. The 401 path that DOES mean
   * "your account was disabled" is already handled by the API client.
   */
  useEffect(() => {
    if (!token) return undefined;

    let cancelled = false;

    const recheck = async () => {
      try {
        const { data } = await client.get('/api/auth/me');
        const fresh = data.data.user;
        if (cancelled || !fresh) return;

        setUser((current) => {
          if (!current) return fresh;
          if (current.role === fresh.role) return current;

          // Said out loud: the navigation and the pages available are about to
          // change, and without this it reads as the app breaking.
          toast(`Your role is now ${fresh.role}. What you can see has changed.`, {
            icon: '🔑',
            duration: 6000,
          });
          return fresh;
        });
      } catch {
        // Ignored on purpose — see the note above.
      }
    };

    const onFocus = () => recheck();
    window.addEventListener('focus', onFocus);
    const timer = setInterval(recheck, 5 * 60_000);

    return () => {
      cancelled = true;
      window.removeEventListener('focus', onFocus);
      clearInterval(timer);
    };
  }, [token]);

  // Shared by login/quickLogin: both return the same { token, user }
  // payload, so the session is established the same way.
  const establishSession = (data) => {
    const { token: newToken, user: userData } = data;
    localStorage.setItem('token', newToken);
    setToken(newToken);
    setUser(userData);
    return userData;
  };

  const login = async (email, password) => {
    const { data } = await client.post('/api/auth/login', { email, password });
    if (data.success) return establishSession(data.data);
    throw new Error('Login failed');
  };

  const quickLogin = async (target) => {
    const payload = typeof target === 'string' ? { email: target } : target;
    const { data } = await client.post('/api/test/quick-login', payload);
    if (data.success) return establishSession(data.data);
    throw new Error('Quick login failed');
  };

  const logout = () => {
    localStorage.removeItem('token');
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
    <AuthContext.Provider value={{ user, token, login, quickLogin, logout, refreshUser, isLoading, connectionError }}>
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
