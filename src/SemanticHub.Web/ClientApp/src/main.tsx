import React from "react";
import ReactDOM from "react-dom/client";
import { BrowserRouter, Navigate, Route, Routes } from "react-router-dom";
import "./styles/tokens.css";
import "./styles/base.css";
import "./styles/app.css";
import "./stores/ui"; // applies the theme before first render
import { AppShell } from "./components/AppShell";
import { HubPage } from "./pages/HubPage";
import { DashboardPage } from "./pages/DashboardPage";
import { AuditPage } from "./pages/AuditPage";

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <BrowserRouter>
      <Routes>
        <Route element={<AppShell />}>
          <Route index element={<HubPage />} />
          <Route path="models/:id" element={<DashboardPage />} />
          <Route path="audit" element={<AuditPage />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Route>
      </Routes>
    </BrowserRouter>
  </React.StrictMode>,
);
