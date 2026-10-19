import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { Snapshot } from "./pages/Snapshot";

// A photo for the server's camera is the stage alone: none of the app around it.
const photo = window.location.hash.startsWith("#/snapshot");

createRoot(document.getElementById("root")!).render(<StrictMode>{photo ? <Snapshot /> : <App />}</StrictMode>);
