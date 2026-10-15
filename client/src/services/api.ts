import axios from "axios";
export const api = axios.create({
  baseURL: import.meta.env.VITE_API_URL || "/api/v1",
  withCredentials: true,
  headers: { "Content-Type": "application/json" },
});
api.interceptors.response.use(
  (r) => r,
  (err) => {
    if (err.response?.status === 401)
      window.dispatchEvent(new CustomEvent("sggs:unauthorized"));
    return Promise.reject(err);
  },
);
