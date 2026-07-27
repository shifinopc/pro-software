import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App, { ResetPasswordScreen } from "./app/App";
import { getResetToken } from "./app/reset";
import "./styles/index.css";

const resetToken = getResetToken();

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    {resetToken ? <ResetPasswordScreen token={resetToken} /> : <App />}
  </StrictMode>,
);
