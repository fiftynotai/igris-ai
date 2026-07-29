import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import "./styles/tokens.css";
import "./styles/base.css";
import { App } from "./App";

const host = document.getElementById("root");
if (host) {
  createRoot(host).render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
}
