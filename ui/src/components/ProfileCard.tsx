import type { ProfileInfo } from '../api';

export function ProfileCard(props: { name: string; profile: ProfileInfo }) {
  const { name, profile } = props;

  return (
    <div className="profile-card">
      <div className="profile-name">{name}</div>
      {profile.model && (
        <div className="profile-field">
          <span className="profile-label">Model</span>
          <span>{profile.model}</span>
        </div>
      )}
      {profile.tools && profile.tools.length > 0 && (
        <div className="profile-field">
          <span className="profile-label">Tools</span>
          <span>{profile.tools.join(', ')}</span>
        </div>
      )}
      {profile.temperature !== undefined && (
        <div className="profile-field">
          <span className="profile-label">Temperature</span>
          <span>{profile.temperature}</span>
        </div>
      )}
      {profile.instructions && (
        <div className="profile-field">
          <span className="profile-label">Instructions</span>
          <span className="profile-instructions">{profile.instructions}</span>
        </div>
      )}
    </div>
  );
}
