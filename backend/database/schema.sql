-- Create users table
CREATE TABLE users (
    id UUID REFERENCES auth.users(id) ON DELETE CASCADE PRIMARY KEY,
    email TEXT UNIQUE NOT NULL,
    subscription_tier TEXT DEFAULT 'free',
    total_recorded_seconds INTEGER DEFAULT 0,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Enable RLS for users
ALTER TABLE users ENABLE ROW LEVEL SECURITY;

-- Users can read their own profile
CREATE POLICY "Users can read own data" ON users
FOR SELECT USING (auth.uid() = id);

-- Users can update their own profile (or service role can bypass)
CREATE POLICY "Users can update own data" ON users
FOR UPDATE USING (auth.uid() = id);

-- Create meetings table
CREATE TABLE meetings (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id UUID REFERENCES users(id) ON DELETE CASCADE NOT NULL,
    transcript TEXT,
    summary JSONB,
    duration_seconds INTEGER DEFAULT 0,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Enable RLS for meetings
ALTER TABLE meetings ENABLE ROW LEVEL SECURITY;

-- Users can read their own meetings
CREATE POLICY "Users can read own meetings" ON meetings
FOR SELECT USING (auth.uid() = user_id);

-- Users can insert their own meetings
CREATE POLICY "Users can insert own meetings" ON meetings
FOR INSERT WITH CHECK (auth.uid() = user_id);
