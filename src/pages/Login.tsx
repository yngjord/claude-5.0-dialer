import { useState, type FormEvent } from 'react';
import { useAuth } from '../auth/AuthProvider';
import { Button } from '../components/ui/Button';
import { Spinner } from '../components/ui/Spinner';

export default function Login() {
  const { signIn } = useAuth();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const onSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      await signIn(email.trim(), password);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Sign in failed.');
      setSubmitting(false);
    }
  };

  return (
    <div className="relative flex min-h-screen items-center justify-center overflow-hidden bg-brand px-4 py-12">
      <div aria-hidden className="absolute inset-0 bg-cover bg-center" style={{ backgroundImage: 'url(/login-bg.jpg)' }} />
      <div aria-hidden className="absolute inset-0 bg-black/20" />

      <form onSubmit={onSubmit} noValidate className="relative w-full max-w-[440px] animate-appear rounded-[28px] bg-white p-8 shadow-2xl shadow-black/20 sm:p-10">
        <img src="/maronly-mark.png" alt="Maronly" className="mx-auto h-16 w-16" />
        <h1 className="mb-8 mt-5 text-center font-display text-[28px] font-normal text-ink">Maronly Dialer</h1>

        <div className="space-y-4">
          <div>
            <label htmlFor="email" className="mb-2 block text-sm font-medium text-ink-soft">
              Email
            </label>
            <input id="email" type="email" autoComplete="email" required className="field" placeholder="Enter your email" value={email} onChange={(e) => setEmail(e.target.value)} />
          </div>
          <div>
            <label htmlFor="password" className="mb-2 block text-sm font-medium text-ink-soft">
              Password
            </label>
            <input id="password" type="password" autoComplete="current-password" required className="field" placeholder="Enter your password" value={password} onChange={(e) => setPassword(e.target.value)} />
          </div>

          {error && (
            <p role="alert" className="rounded-2xl bg-red-50 px-4 py-3 text-sm text-red-700">
              {error}
            </p>
          )}

          <Button type="submit" size="md" className="!mt-6 w-full" disabled={submitting}>
            {submitting ? (
              <>
                <Spinner /> Signing in…
              </>
            ) : (
              'Sign in'
            )}
          </Button>
        </div>
      </form>
    </div>
  );
}
