class User < ApplicationRecord
  has_many :posts, dependent: :destroy
  has_many :comments, dependent: :destroy
  has_one :profile, dependent: :destroy
  has_and_belongs_to_many :groups

  scope :active, -> { where(active: true) }
  scope :recent_signups, ->(days = 30) { where(created_at: days.ago..) }
  scope :by_role, ->(role) { where(role: role) }

  validates :email, presence: true, uniqueness: true

  def self.search(query)
    where("name LIKE ?", "%#{query}%")
  end

  def display_name
    name.presence || email
  end
end
