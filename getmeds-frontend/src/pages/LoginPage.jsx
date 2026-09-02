import React, { useState } from 'react';
import { useAuth } from '../context/AuthContext';
import { useNavigate, Link } from 'react-router-dom';
import ErrorMessage from '../components/ui/ErrorMessage';
import LoadingSpinner from '../components/ui/LoadingSpinner';
import { EyeOff, FlaskConical, ArrowRight } from 'lucide-react';
import employeeBg from '../assets/employee.jpg';

const LoginPage = () => {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState(null);
  const [isLoading, setIsLoading] = useState(false);
  const { login, quickLogin } = useAuth();
  const navigate = useNavigate();

  const handleSubmit = async (e) => {
    e.preventDefault();
    setError(null);
    setIsLoading(true);
    
    try {
      await login(email, password);
      navigate('/');
    } catch (err) {
      setError(err.response?.data?.message || 'Failed to log in. Please check your credentials.');
    } finally {
      setIsLoading(false);
    }
  };

  const handleTestHubLogin = async () => {
    setError(null);
    setIsLoading(true);
    try {
      if (quickLogin) {
        await quickLogin('admin@getmeds.ph');
      } else {
        await login('admin@getmeds.ph', 'demo123');
      }
      navigate('/dashboard');
    } catch (err) {
      try {
        await login('admin@getmeds.ph', 'demo123');
        navigate('/dashboard');
      } catch (fallbackErr) {
        setError(err.response?.data?.error?.message || err.response?.data?.message || 'God-Mode login failed');
      }
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <div className="h-screen w-full flex font-sans relative overflow-hidden bg-gray-900">
      
      {/* Full Screen Background Image */}
      <div 
        className="absolute inset-0 z-0 bg-cover bg-center"
        style={{ backgroundImage: `url(${employeeBg})` }}
      ></div>
      
      {/* Blue Shadow / Overlay */}
      <div className="absolute inset-0 z-0 bg-gradient-to-r from-getmeds-blue-dark/90 to-getmeds-blue/40 mix-blend-multiply"></div>
      <div className="absolute inset-0 z-0 bg-getmeds-blue-dark/30"></div> {/* Extra tint */}

      {/* Content Container */}
      <div className="relative z-10 flex flex-col md:flex-row items-center justify-between w-full h-full max-w-7xl mx-auto p-6 md:p-12">
        
        {/* Left Side: Texts */}
        <div className="flex-1 flex flex-col justify-center pr-10 text-white mb-10 md:mb-0">
          <h1 className="text-4xl md:text-5xl font-semibold mb-4 tracking-tight leading-tight">
            Getmeds System
          </h1>
          <p className="text-base md:text-lg text-blue-100/90 max-w-lg font-medium">
            Your centralized portal for seamless medical supply management and operations.
          </p>
        </div>

        {/* Right Side: Login Form Container */}
        <div className="w-full max-w-[420px] bg-white rounded-2xl p-10 shadow-2xl">
          
          <div className="w-full mx-auto">
            <h2 className="text-[26px] font-semibold text-center text-ink-primary">
              Welcome Back!
            </h2>
            <p className="text-[14px] text-ink-secondary text-center mt-2 mb-8">
              We missed you! Please enter your details.
            </p>

            {import.meta.env.VITE_TEST_MODE === 'true' && (
              <div className="mb-6">
                <button
                  type="button"
                  onClick={handleTestHubLogin}
                  disabled={isLoading}
                  className="w-full py-2.5 px-4 rounded-xl border border-amber-300 bg-amber-50 hover:bg-amber-100 text-amber-900 font-semibold text-xs transition-all flex items-center justify-center gap-2 shadow-2xs group disabled:opacity-50"
                  title="Enter Test Hub"
                >
                  <FlaskConical size={16} className="text-amber-700 group-hover:rotate-12 transition-transform" />
                  <span>Enter Test Hub</span>
                  <ArrowRight size={14} className="text-amber-700 group-hover:translate-x-0.5 transition-transform" />
                </button>
              </div>
            )}

            <form className="space-y-6" onSubmit={handleSubmit}>
              <ErrorMessage message={error} onClose={() => setError(null)} />
              
              <div className="space-y-4">
                <div>
                  <label className="block text-[13px] font-semibold text-ink-primary mb-1.5">Email</label>
                  <input
                    type="email"
                    required
                    placeholder="Enter your Email"
                    className="w-full px-4 py-3.5 rounded-xl border border-slate-200 text-sm focus:outline-none focus:ring-2 focus:ring-getmeds-blue focus:border-transparent placeholder-ink-secondary/50"
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                  />
                </div>
                
                <div>
                  <label className="block text-[13px] font-semibold text-ink-primary mb-1.5">Password</label>
                  <div className="relative">
                    <input
                      type="password"
                      required
                      placeholder="Enter Password"
                      className="w-full px-4 py-3.5 rounded-xl border border-slate-200 text-sm focus:outline-none focus:ring-2 focus:ring-getmeds-blue focus:border-transparent placeholder-ink-secondary/50"
                      value={password}
                      onChange={(e) => setPassword(e.target.value)}
                    />
                    <button type="button" className="absolute right-4 top-3.5 text-ink-secondary hover:text-ink-primary">
                      <EyeOff className="h-5 w-5 mt-0.5" />
                    </button>
                  </div>
                </div>
              </div>

              <div className="pt-4">
                <button
                  type="submit"
                  disabled={isLoading}
                  className="w-full bg-getmeds-blue text-white rounded-xl py-3.5 text-[15px] font-medium hover:bg-getmeds-blue-hover transition-colors focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-getmeds-blue disabled:opacity-70 flex items-center justify-center shadow-lg shadow-getmeds-blue/25"
                >
                  {isLoading ? <LoadingSpinner size="sm" className="mr-2" /> : null}
                  Sign in
                </button>
              </div>

              {/* Sep 2, 2026: sign-up creates a MedRep account only — every
                  other role is still made by an admin on /admin/users. */}
              <p className="text-[13px] text-ink-secondary text-center">
                New here?{' '}
                <Link to="/signup" className="text-getmeds-blue font-semibold hover:underline">
                  Create an account
                </Link>
              </p>
            </form>
          </div>

        </div>
      </div>
    </div>
  );
};

export default LoginPage;
