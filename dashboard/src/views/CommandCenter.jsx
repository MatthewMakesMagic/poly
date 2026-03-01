import React from 'react';
import StatusBar from '../components/StatusBar.jsx';
import KillSwitchPanel from '../components/KillSwitchPanel.jsx';
import StrategiesPanel from '../components/StrategiesPanel.jsx';
import PositionsPanel from '../components/PositionsPanel.jsx';
import ActivityFeed from '../components/ActivityFeed.jsx';

export default function CommandCenter({ state, events, connected }) {
  return (
    <div className="space-y-4">
      {/* Top row: Status + Kill switches */}
      <div className="flex flex-col sm:flex-row gap-4">
        <StatusBar state={state} connected={connected} />
        <KillSwitchPanel state={state} />
      </div>

      {/* Middle row: Strategies + Positions */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        <div className="lg:col-span-1">
          <StrategiesPanel state={state} />
        </div>
        <div className="lg:col-span-2">
          <PositionsPanel state={state} />
        </div>
      </div>

      {/* Bottom: Activity feed */}
      <ActivityFeed events={events} />
    </div>
  );
}
