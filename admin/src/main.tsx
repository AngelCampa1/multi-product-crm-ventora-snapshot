import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./index.css";
import { App } from "./App";
import { ErrorBoundary } from "@admin/components/ErrorBoundary";
import { initMonitoring } from "@admin/lib/monitoring";

const root = document.getElementById("root");
if (!root) throw new Error("Root element not found");

initMonitoring();

createRoot(root).render(
  <StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </StrictMode>
);
