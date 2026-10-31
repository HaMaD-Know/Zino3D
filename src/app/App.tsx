import { useCallback, useState } from 'react';
import { HomeScreen } from '../features/home/HomeScreen';
import { EditorScreen, type EditorLaunch } from '../features/editor/EditorScreen';
import { ToastProvider } from '../components/ui/Toast';

type Screen = { name: 'home' } | { name: 'editor'; launch: EditorLaunch; key: number };

export function App() {
  const [screen, setScreen] = useState<Screen>({ name: 'home' });
  const open = useCallback(
    (launch: EditorLaunch) => setScreen({ name: 'editor', launch, key: Date.now() }),
    [],
  );
  const home = useCallback(() => setScreen({ name: 'home' }), []);
  return (
    <ToastProvider>
      {screen.name === 'home' ? (
        <HomeScreen onOpen={open} />
      ) : (
        <EditorScreen key={screen.key} launch={screen.launch} onExit={home} />
      )}
    </ToastProvider>
  );
}
