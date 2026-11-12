import React from "react";
import { createRoot } from "react-dom/client";
import "../styles.css";
import { LocalApp } from "./app";

createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <LocalApp />
  </React.StrictMode>,
);
