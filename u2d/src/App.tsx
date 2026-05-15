import './App.css'

function App() {
  return (
    <div className="app">
      <nav className="navbar">
        <div className="nav-brand">
          <div className="icon-placeholder">
            <span className="icon-label">ICON</span>
          </div>
          <span className="site-title">Up2Date</span>
        </div>
        <div className="nav-tabs">
          <a href="#" className="nav-tab active">Check for Friends</a>
        </div>
      </nav>

      <main className="hero-section">
        <div className="hero-content">
          <div className="hero-icon-placeholder">
            <span className="hero-icon-label">APP ICON</span>
          </div>
          <h1 className="hero-title">Up2Date</h1>
          <p className="hero-subtitle">Stay connected. Stay informed.</p>
        </div>
      </main>
    </div>
  )
}

export default App
