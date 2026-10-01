import axios from 'axios';

const client = axios.create({
  baseURL: import.meta.env.VITE_API_URL || 'http://localhost:4000',
});

client.interceptors.request.use(
  (config) => {
    const token = localStorage.getItem('token');
    if (token) {
      config.headers.Authorization = `Bearer ${token}`;
    }
    return config;
  },
  (error) => Promise.reject(error)
);

client.interceptors.response.use(
  (response) => response,
  (error) => {
    // Callers that expect a 401/403 as a normal, recoverable outcome (e.g. an
    // optional admin-only widget shown on a page that itself doesn't require
    // login, like the Developer Test Mode page) can pass
    // `{ skipAuthRedirect: true }` in the request config to opt out of the
    // global logout+redirect below and handle the error locally instead.
    const skipAuthRedirect = error.config?.skipAuthRedirect;
    if (error.response && error.response.status === 401 && !skipAuthRedirect) {
      localStorage.removeItem('token');
      window.location.href = '/';
    }
    return Promise.reject(error);
  }
);

export default client;
