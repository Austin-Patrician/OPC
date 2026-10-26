import { Archive, Grid3x3, Hash, Smartphone } from 'lucide-react';
import { PlaceholderPage } from './PlaceholderPage';

export function ChannelsPage() {
  return (
    <PlaceholderPage icon={Hash} titleKey="nav.channels" descriptionKey="org.description" comingSoonKey="org.comingSoon" />
  );
}

export function DeliverablesPage() {
  return (
    <PlaceholderPage
      icon={Archive}
      titleKey="nav.deliverables"
      descriptionKey="market.description"
      comingSoonKey="market.comingSoon"
    />
  );
}

export function SkillsPage() {
  return (
    <PlaceholderPage
      icon={Grid3x3}
      titleKey="nav.skills"
      descriptionKey="org.description"
      comingSoonKey="org.comingSoon"
    />
  );
}

export function DevicePage() {
  return (
    <PlaceholderPage
      icon={Smartphone}
      titleKey="nav.device"
      descriptionKey="org.description"
      comingSoonKey="org.comingSoon"
    />
  );
}
