import React, { createContext, useState, useEffect, useContext } from 'react';
import client from '../api/client';
import toast from 'react-hot-toast';

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
    const timer = setInterval(recheck, 60_000);

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
    <AuthContext.Provider value={{ user, token, login, quickLogin, logout, refreshUser, isLoading }}>
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
