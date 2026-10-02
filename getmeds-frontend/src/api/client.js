import axios from 'axios';

const client = axios.create({
  baseURL: import.meta.env.VITE_API_URL || 'http://localhost:4000',
});

client.interceptors.request.use(
  (config) => {
    // localStorage (Oct 1, 2026, was sessionStorage): the token has to survive a
    // closed tab or a restarted browser, or people are signed out every time.
    const token = localStorage.getItem('token');
    if (token) {
      config.headers.Authorization = `Bearer ${token}`;
    }
    return config;
  },
  (error) => Promise.reject(error)
);

// Oct 2, 2026: a read that fails because the server or database is briefly
// unavailable (no response at all, or 502/503/504) is tried again, quietly,
// before anything is shown. Reads only: repeating a write could do it twice.
const RETRY_DELAYS_MS = [1000, 3000];
const isTransient = (error) => {
  if (!error.response) return error.code !== 'ERR_CANCELED'; // network drop / timeout
  return [502, 503, 504].includes(error.response.status);
};

client.interceptors.response.use(
  (response) => response,
  async (error) => {
    const config = error.config;
    if (config && (config.method || 'get').toLowerCase() === 'get' && isTransient(error)) {
      const attempt = config.__retryCount || 0;
      if (attempt < RETRY_DELAYS_MS.length) {
        config.__retryCount = attempt + 1;
        await new Promise((resolve) => setTimeout(resolve, RETRY_DELAYS_MS[attempt]));
        return client(config);
      }
    }

    // Callers that expect a 401/403 as a normal, recoverable outcome (e.g. an
    // optional admin-only widget shown on a page that itself doesn't require
    // login, like the Developer Test Mode page) can pass
    // `{ skipAuthRedirect: true }` in the request config to opt out of the
    // global logout+redirect below and handle the error locally instead.
    //
    // Oct 2, 2026: only the backend's "your login is no longer valid" answer
    // ends the session (code UNAUTHORIZED, from the token check). A wrong
    // password at sign-in (INVALID_CREDENTIALS), a database error (503) or a
    // dropped connection used to log the user out too, and must not.
    const skipAuthRedirect = config?.skipAuthRedirect;
    const code = error.response?.data?.error?.code;
    if (error.response?.status === 401 && code === 'UNAUTHORIZED' && !skipAuthRedirect) {
      localStorage.removeItem('token');
      window.location.href = '/';
    }
    return Promise.reject(error);
  }
);

export default client;
