import React from 'react';
import { Routes, Route, Link } from 'react-router-dom';
import HomePage from './pages/HomePage';
import ImportPage from './pages/ImportPage';
import SetupPage from './pages/SetupPage';
import PlayPage from './pages/PlayPage';
import ResultPage from './pages/ResultPage';
import RulesPage from './pages/RulesPage';
import AchievementsPage from './pages/AchievementsPage';

export default function App() {
  return (
    <div className="container">
      <header className="row" style={{alignItems:'center', justifyContent:'space-between'}}>
        <div style={{display:'flex', gap:12, alignItems:'center'}}>
          <h2 style={{margin:0}}>指宿枕崎線 サイクルロゲイニング（MVP）</h2>
        </div>
        <nav style={{display:'flex', gap:10, flexWrap:'wrap'}}>
          <Link to="/" className="btn">ホーム</Link>
          <Link to="/admin/import" className="btn">CSV取込</Link>
          <Link to="/rules" className="btn">ゲームルール</Link>
        </nav>
      </header>
      <div style={{height:12}} />
      <Routes>
        <Route path="/" element={<HomePage />} />
        <Route path="/admin/import" element={<ImportPage />} />
        <Route path="/setup" element={<SetupPage />} />
        <Route path="/play" element={<PlayPage />} />
        <Route path="/result" element={<ResultPage />} />
        <Route path="/rules" element={<RulesPage />} />
        <Route path="/achievements" element={<AchievementsPage />} />
      </Routes>
    </div>
  );
}
