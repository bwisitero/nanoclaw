#!/bin/bash
set -e

echo "🚀 Setting up PostgreSQL + pgvector for NanoClaw"
echo ""

# Check if running on macOS
if [[ "$OSTYPE" != "darwin"* ]]; then
    echo "⚠️  This script is designed for macOS. For Linux, adapt the commands."
    exit 1
fi

# Check if Homebrew is installed
if ! command -v brew &> /dev/null; then
    echo "❌ Homebrew not found. Install from https://brew.sh"
    exit 1
fi

# Step 1: Install PostgreSQL
echo "📦 Installing PostgreSQL 16..."
if ! brew list postgresql@16 &> /dev/null; then
    brew install postgresql@16
else
    echo "✅ PostgreSQL 16 already installed"
fi

# Step 2: Install pgvector
echo "📦 Installing pgvector extension..."
if ! brew list pgvector &> /dev/null; then
    brew install pgvector
else
    echo "✅ pgvector already installed"
fi

# Step 3: Start PostgreSQL service
echo "🔄 Starting PostgreSQL service..."
brew services start postgresql@16

# Wait for PostgreSQL to be ready
echo "⏳ Waiting for PostgreSQL to start..."
sleep 3

# Step 4: Create database
echo "🗄️  Creating nanoclaw_vectors database..."
if psql -lqt | cut -d \| -f 1 | grep -qw nanoclaw_vectors; then
    echo "✅ Database nanoclaw_vectors already exists"
else
    createdb nanoclaw_vectors
    echo "✅ Created nanoclaw_vectors database"
fi

# Step 5: Enable extensions
echo "🔌 Enabling pgvector and pg_trgm extensions..."
psql nanoclaw_vectors -c "CREATE EXTENSION IF NOT EXISTS vector;" > /dev/null
psql nanoclaw_vectors -c "CREATE EXTENSION IF NOT EXISTS pg_trgm;" > /dev/null
echo "✅ Extensions enabled"

# Step 6: Run schema
echo "📋 Creating database schema..."
psql nanoclaw_vectors < docs/pgvector-schema.sql > /dev/null
echo "✅ Schema created"

# Step 7: Verify installation
echo ""
echo "🔍 Verifying installation..."
TABLES=$(psql nanoclaw_vectors -t -c "SELECT COUNT(*) FROM information_schema.tables WHERE table_schema='public';")
echo "   Tables created: $TABLES"

VECTOR_EXT=$(psql nanoclaw_vectors -t -c "SELECT COUNT(*) FROM pg_extension WHERE extname='vector';")
if [[ "$VECTOR_EXT" == "1" ]]; then
    echo "   ✅ pgvector extension active"
else
    echo "   ❌ pgvector extension not found"
    exit 1
fi

# Step 8: Setup Python embedding service
echo ""
echo "🐍 Setting up Python embedding service..."
cd services/embedding-service

if [[ ! -d "venv" ]]; then
    echo "   Creating virtual environment..."
    python3 -m venv venv
fi

echo "   Installing dependencies..."
source venv/bin/activate
pip install --quiet --upgrade pip
pip install --quiet -r requirements.txt

echo "   Testing embedding service..."
TEST_OUTPUT=$(echo '{"id":1,"method":"embed_query","params":{"query":"test"}}' | python server.py)
if echo "$TEST_OUTPUT" | grep -q '"result"'; then
    echo "   ✅ Embedding service working"
else
    echo "   ❌ Embedding service test failed"
    exit 1
fi

deactivate
cd ../..

# Step 9: Update .env
echo ""
echo "📝 Updating .env file..."
if ! grep -q "PGVECTOR_HOST" .env 2>/dev/null; then
    cat >> .env << EOF

# PostgreSQL + pgvector
PGVECTOR_HOST=localhost
PGVECTOR_PORT=5432
PGVECTOR_DB=nanoclaw_vectors
PGVECTOR_USER=$USER
EOF
    echo "✅ Added pgvector config to .env"
else
    echo "✅ pgvector config already in .env"
fi

# Done
echo ""
echo "✅ PostgreSQL + pgvector setup complete!"
echo ""
echo "Next steps:"
echo "1. Install Node.js dependencies: npm install pg"
echo "2. Build NanoClaw: npm run build"
echo "3. Restart service: launchctl kickstart -k gui/\$(id -u)/com.nanoclaw"
echo ""
echo "Verify with: psql nanoclaw_vectors -c 'SELECT COUNT(*) FROM conversation_embeddings;'"
