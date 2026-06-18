import { BrowserRouter, Route, Routes } from "react-router";

import { ThemeProvider } from "@/components/theme-provider";
import Auth from "./pages/Auth";
import Dashboard from "./pages/Dashboard";

export function App() {
  return (
    <ThemeProvider>
      <BrowserRouter>
        <Routes>
          <Route path="/" element={<Dashboard />} />
          <Route path="/auth" element={<Auth />} />
        </Routes>
      </BrowserRouter>
    </ThemeProvider>
  );
}

export default App;
