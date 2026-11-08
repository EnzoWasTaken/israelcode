import { SettingsCard } from "./settings-section";
import { KeepAwakeButton } from "./KeepAwakeButton";
import { BackgroundSessionList, listableRows, useBackgroundSessions } from "./BackgroundSessions";
import "./SettingsPages.css";

/** Settings → Sessions & background. */
export function SettingsSessions(): React.ReactElement {
  const rows = useBackgroundSessions();
  const count = listableRows(rows).length;
  return (
    <>
      <SettingsCard
        title="Background tasks"
        description="Conversations that keep working while you are elsewhere."
      >
        {count === 0 ? (
          <p className="sp-help">Nothing is running or waiting right now.</p>
        ) : (
          <>
            <BackgroundSessionList rows={rows} onOpen={() => {}} canOpen={false} />
            <p className="sp-help">
              To open one, use Home or the background indicator in a window&rsquo;s title bar.
            </p>
          </>
        )}
      </SettingsCard>
      <SettingsCard
        title="Keep awake"
        description="Stop the computer sleeping mid-task. The screen can still turn off."
      >
        <div className="sp-inline">
          <KeepAwakeButton />
        </div>
      </SettingsCard>
      <SettingsCard
        title="Close, stop and delete"
        description="What each action does, and what happens when things shut down."
      >
        <dl className="sp-defs">
          <div>
            <dt>Close a window</dt>
            <dd>
              A running task keeps going in the background. On macOS and Windows, closing the last
              window leaves the app in the tray while tasks run; on Linux, closing the last window
              quits the app.
            </dd>
          </div>
          <div>
            <dt>Stop task</dt>
            <dd>Ends the current work. The conversation stays in your history.</dd>
          </div>
          <div>
            <dt>Remove from list</dt>
            <dd>Takes a finished task off this list. The conversation stays in your history.</dd>
          </div>
          <div>
            <dt>Delete</dt>
            <dd>Stops any work and deletes the conversation. This can&rsquo;t be undone.</dd>
          </div>
          <div>
            <dt>Quit the app, stop the backend, or restart the device</dt>
            <dd>
              Work stops: nothing runs without the app. Those tasks show as Interrupted when you
              come back, and their history is kept.
            </dd>
          </div>
        </dl>
      </SettingsCard>
    </>
  );
}
