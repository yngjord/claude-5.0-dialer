import { ArrowLeft } from 'lucide-react';
import { Link, useParams } from 'react-router-dom';
import { CallDetail } from '../components/CallDetail';

export default function CallDetailPage() {
  const { id = '' } = useParams();
  return (
    <>
      <Link to="/calls" className="mb-4 inline-flex items-center gap-1 text-sm text-ink-muted hover:text-brand">
        <ArrowLeft size={15} /> Call logs
      </Link>
      <div className="card max-w-3xl animate-appear p-6 sm:p-8">
        <CallDetail callId={id} />
      </div>
    </>
  );
}
