class Post < ApplicationRecord
  belongs_to :user
  has_many :comments, dependent: :destroy
  has_many :commenters, through: :comments, source: :user

  scope :published, -> { where(published: true) }
  scope :recent, ->(days = 7) { where(created_at: days.ago..) }

  def self.search(query)
    where("title LIKE ?", "%#{query}%")
  end

  def excerpt(length = 100)
    body.to_s[0, length]
  end
end
