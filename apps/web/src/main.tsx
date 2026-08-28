import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import { App } from "./App.js";
import { resolveRuntimeBasePath } from "./runtime-base-path.js";
import "./styles.css";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <BrowserRouter basename={resolveRuntimeBasePath()}>
      <App />
    </BrowserRouter>
  </StrictMode>,
);
