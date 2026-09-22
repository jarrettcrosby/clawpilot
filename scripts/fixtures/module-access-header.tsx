export default function Header({ onToggleDesktopNav, onOpenMobileNav }: { onToggleDesktopNav: () => void; onOpenMobileNav: () => void }) {
  return <header><button onClick={onToggleDesktopNav}>Toggle sidebar</button><button onClick={onOpenMobileNav}>Open menu</button></header>
}
