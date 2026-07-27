import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { ClientPortalApp, ResetPasswordScreen } from "./app/App";
import { getResetToken } from "./app/reset";
import "./styles/index.css";
import "./styles/portal-theme.css"; // portal-only re-skin — loaded AFTER index.css so it overrides

const resetToken = getResetToken();

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    {resetToken ? <ResetPasswordScreen token={resetToken} /> : <ClientPortalApp />}
  </StrictMode>,
);
