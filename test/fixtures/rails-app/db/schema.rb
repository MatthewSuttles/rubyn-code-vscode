ActiveRecord::Schema[7.1].define(version: 2024_01_01_000000) do
  create_table "users", force: :cascade do |t|
    t.string "name", null: false
    t.string "email", null: false
    t.boolean "active", default: true, null: false
    t.string "role", default: "member"
    t.timestamps
    t.index ["email"], unique: true
  end

  create_table "posts", force: :cascade do |t|
    t.string "title", null: false
    t.text "body"
    t.boolean "published", default: false
    t.references "user", null: false, foreign_key: true
    t.timestamps
  end

  create_table "comments", force: :cascade do |t|
    t.text "body", null: false
    t.references "user", null: false, foreign_key: true
    t.references "commentable", polymorphic: true, null: false
    t.timestamps
  end
end
